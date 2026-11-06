import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { failureMessage, runLobbystack, whoami, type LobbystackOptions } from "./lobbystack.ts";
import { readResults } from "./report.ts";
import { TEXT_FILE, type Result } from "./run.ts";

export type UploadSource = "text" | "pdf";

/** One upload, as <output>/uploads.json records it, so remove takes away exactly what upload added. */
export type UploadRecord = {
  document: string;
  /** The reader whose text went up, or "pdf" for the PDF itself. */
  kind: string;
  file: string;
  title: string;
  tags: string[];
  url: string;
  business: string;
  sourceId: string | null;
  status: string;
  error: string | null;
  uploadedAt: string;
};

export const UPLOADS_FILE = "uploads.json";
const maxUploadBytes = 25 * 1024 * 1024;

export async function readUploads(output: string): Promise<UploadRecord[]> {
  const content = await readFile(path.join(output, UPLOADS_FILE), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return content ? ((JSON.parse(content) as { uploads: UploadRecord[] }).uploads ?? []) : [];
}

async function writeUploads(output: string, uploads: readonly UploadRecord[]): Promise<void> {
  await writeFile(path.join(output, UPLOADS_FILE), `${JSON.stringify({ note: "Written by pdf-parsing upload. pdf-parsing remove deletes these sources from the business.", uploads }, null, 2)}\n`);
}

type Planned = { result: Result; file: string; title: string; skip?: string };

async function plan(output: string, results: readonly Result[], source: UploadSource, parser: string | undefined): Promise<Planned[]> {
  const chosen = source === "pdf" ? [...new Map(results.map((result) => [result.name, result])).values()] : results.filter((result) => result.parser === parser);
  const kind = source === "pdf" ? "pdf" : (parser ?? "");
  return await Promise.all(chosen.map(async (result): Promise<Planned> => {
    const file = source === "pdf" ? result.input : path.join(output, result.name, result.parser, TEXT_FILE);
    const title = `${result.name} (${kind})`;
    if (source === "text" && result.error) return { result, file, title, skip: `the ${result.parser} reader failed: ${result.error}` };
    const size = (await stat(file).catch(() => undefined))?.size;
    if (size === undefined) return { result, file, title, skip: `there's no file at ${file}` };
    if (size === 0) return { result, file, title, skip: "the reader found no text" };
    if (size > maxUploadBytes) return { result, file, title, skip: "it is over the 25 MB upload limit" };
    return { result, file, title };
  }));
}

export type UploadRun = { output: string; parser: string | undefined; source: UploadSource; tags: string[]; dryRun: boolean; lobbystack: LobbystackOptions; log(line: string): void };

/**
 * Uploads one reader's text as Markdown (or the PDFs) to the test business. The deployment
 * reads a Markdown file as it is and runs the same chunkText on it, so the knowledge it stores
 * is what that reader would have given the receptionist.
 */
export async function uploadResults(run: UploadRun): Promise<number> {
  const results = await readResults(run.output);
  if (run.parser && !results.some((result) => result.parser === run.parser)) throw new Error(`There are no ${run.parser} results in ${run.output}. Run parse with --parser ${run.parser} first.`);
  if (!results.length) throw new Error(`There are no results in ${run.output}. Run parse first.`);
  const kind = run.source === "pdf" ? "pdf" : (run.parser ?? "");
  const tags = [...new Set(["pdf-parsing", `parser:${kind}`, ...run.tags])];
  const planned = await plan(run.output, results, run.source, run.parser);
  if (run.dryRun) {
    run.log(`Would upload ${planned.filter((entry) => !entry.skip).length} file(s), tagged ${tags.join(", ")}:`);
    for (const entry of planned) run.log(`  ${entry.title}: ${entry.skip ? `skipped, ${entry.skip}` : entry.file}`);
    return 0;
  }
  const me = await whoami(run.lobbystack);
  const business = me.business?.id ?? "";
  run.log(`Uploading to ${me.business?.name ?? ""} (${business}) on ${me.url}, tagged ${tags.join(", ")}.`);
  const uploads = await readUploads(run.output);
  let failed = 0;
  for (const entry of planned) {
    if (entry.skip) {
      run.log(`  ${entry.title}: skipped, ${entry.skip}`);
      continue;
    }
    const earlier = uploads.find((upload) => upload.document === entry.result.name && upload.kind === kind && upload.business === business && upload.url === me.url && upload.sourceId);
    if (earlier) {
      run.log(`  ${entry.title}: skipped, already uploaded as ${earlier.sourceId}; run remove first to upload it again`);
      continue;
    }
    const cli = await runLobbystack(run.lobbystack, ["knowledge", "upload", entry.file, "--title", entry.title, "--tags", tags.join(","), "--wait"]);
    let source: { id?: string; status?: string; error?: string | null } = {};
    try {
      source = JSON.parse(cli.stdout) as typeof source;
    } catch {
      // Nothing on stdout: the upload never made a source.
    }
    const error = cli.code === 0 ? null : failureMessage(cli);
    if (error) failed += 1;
    uploads.push({ document: entry.result.name, kind, file: entry.file, title: entry.title, tags, url: me.url, business, sourceId: source.id ?? null, status: source.status ?? "failed", error, uploadedAt: new Date().toISOString() });
    // Saved after every file, so a stopped run still lists what it uploaded.
    await writeUploads(run.output, uploads);
    run.log(`  ${entry.title}: ${error ? `failed, ${error}` : `${source.status ?? "uploaded"} as ${source.id ?? "?"}`}`);
  }
  run.log(`Recorded in ${path.join(run.output, UPLOADS_FILE)}.`);
  return failed ? 1 : 0;
}

export type RemoveRun = { output: string; parser: string | undefined; dryRun: boolean; lobbystack: LobbystackOptions; log(line: string): void };

/** Removes from the business the sources uploads.json lists for this deployment, and only those. */
export async function removeUploads(run: RemoveRun): Promise<number> {
  const uploads = await readUploads(run.output);
  const chosen = uploads.filter((upload) => upload.sourceId && (!run.parser || upload.kind === run.parser));
  if (!chosen.length) {
    run.log(`Nothing to remove: ${path.join(run.output, UPLOADS_FILE)} lists no uploads${run.parser ? ` for ${run.parser}` : ""}.`);
    return 0;
  }
  if (run.dryRun) {
    run.log(`Would remove ${chosen.length} source(s):`);
    for (const upload of chosen) run.log(`  ${upload.title}: ${upload.sourceId} in business ${upload.business} on ${upload.url}`);
    return 0;
  }
  const me = await whoami(run.lobbystack);
  const here = chosen.filter((upload) => upload.business === me.business?.id && upload.url === me.url);
  if (here.length < chosen.length) run.log(`${chosen.length - here.length} upload(s) belong to another business or deployment and were left alone; pass that one's --business or --profile.`);
  let failed = 0;
  for (const upload of here) {
    const cli = await runLobbystack(run.lobbystack, ["knowledge", "source-remove", upload.sourceId ?? ""]);
    const error = cli.code === 0 ? null : failureMessage(cli);
    // A source someone already deleted is gone either way.
    const gone = !error || /not found|no such|doesn't exist/iu.test(error);
    if (gone) uploads.splice(uploads.indexOf(upload), 1);
    else failed += 1;
    run.log(`  ${upload.title}: ${gone ? `removed ${upload.sourceId}` : `failed, ${error}`}`);
  }
  await writeUploads(run.output, uploads);
  return failed ? 1 : 0;
}
