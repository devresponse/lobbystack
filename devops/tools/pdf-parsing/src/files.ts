import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export type InputFile = { path: string; relative: string; name: string };

/** The PDFs to read: the file itself, or every .pdf in the folder (and its subfolders with recursive), sorted by name. */
export async function listPdfs(input: string, recursive: boolean): Promise<InputFile[]> {
  const info = await stat(input).catch(() => undefined);
  if (!info) throw new Error(`There's no file or folder at ${input}.`);
  if (info.isFile()) {
    if (path.extname(input).toLowerCase() !== ".pdf") throw new Error(`${input} isn't a PDF.`);
    return withNames([{ path: input, relative: path.basename(input) }]);
  }
  const found: Array<{ path: string; relative: string }> = [];
  const walk = async (folder: string) => {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory() && recursive) await walk(full);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".pdf") found.push({ path: full, relative: path.relative(input, full) });
    }
  };
  await walk(input);
  return withNames(found);
}

/** Folder names for the outputs: the path without .pdf, with folders joined by "__", made safe for every file system and unique. */
function withNames(files: ReadonlyArray<{ path: string; relative: string }>): InputFile[] {
  const used = new Set<string>();
  return files.map((file) => {
    const base = file.relative.slice(0, -path.extname(file.relative).length).split(/[\\/]+/u).join("__").replace(/[<>:"|?*\u0000-\u001f]/gu, "_").replace(/[. ]+$/u, "") || "document";
    let name = base;
    for (let copy = 2; used.has(name.toLowerCase()); copy += 1) name = `${base}-${copy}`;
    used.add(name.toLowerCase());
    return { ...file, name };
  });
}
