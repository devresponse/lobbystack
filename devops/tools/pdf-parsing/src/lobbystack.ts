import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

/** Which lobbystack CLI to run, and the business and profile to pass it. */
export type LobbystackOptions = { cli: string; business: string | undefined; profile: string | undefined };

export type CliRun = { code: number; stdout: string; stderr: string };

/** What `lobbystack whoami --json` prints, as far as this tool reads it. */
export type Whoami = { profile: string | null; url: string; business: { id: string; name: string } | null };

export async function ensureCli(options: LobbystackOptions): Promise<void> {
  await access(options.cli).catch(() => {
    throw new Error(`There's no lobbystack CLI at ${options.cli}. Build it once from the repository's root with pnpm --filter @lobbystack/cli build, or pass --cli <bin.js>.`);
  });
}

/**
 * Runs the lobbystack CLI with Node itself, never through a shell, so file names and questions
 * pass as they are on every system. The CLI reads its own saved profile or LOBBYSTACK_* variables.
 */
export async function runLobbystack(options: LobbystackOptions, args: readonly string[]): Promise<CliRun> {
  const full = [options.cli, ...args, ...(options.business ? ["--business", options.business] : []), ...(options.profile ? ["--profile", options.profile] : []), "--json"];
  return await new Promise<CliRun>((resolve, reject) => {
    const child = spawn(process.execPath, full, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** The CLI's message for a failed run: the error JSON it prints with --json, or whatever it printed. */
export function failureMessage(run: CliRun): string {
  try {
    const parsed = JSON.parse(run.stderr) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // Not JSON: show it as it came.
  }
  return (run.stderr || run.stdout).trim() || `exit code ${run.code}`;
}

export async function lobbystackJson<T>(options: LobbystackOptions, args: readonly string[]): Promise<T> {
  const run = await runLobbystack(options, args);
  if (run.code !== 0) throw new Error(`lobbystack ${args[0] ?? ""} ${args[1] ?? ""} failed: ${failureMessage(run)}`.replace(/ {2,}/gu, " "));
  return JSON.parse(run.stdout) as T;
}

/** Checks the key works and says which deployment and business the commands will change. */
export async function whoami(options: LobbystackOptions): Promise<Whoami> {
  await ensureCli(options);
  const me = await lobbystackJson<Whoami>(options, ["whoami"]);
  if (!me.business) throw new Error("The API key isn't tied to a business: pass --business <id> for the test business.");
  return me;
}
