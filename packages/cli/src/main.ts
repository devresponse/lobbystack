import { parseArgs } from "node:util";

import { isUuid } from "@lobbystack/shared";

import { createClient, type Client } from "./client";
import { DEFAULT_PROFILE, assertProfileName, configPath, keyPrefix, normalizeBaseUrl, readConfig, resolveConnection, writeConfig, type Connection } from "./config";
import { ApiError, CliError, exitCodes, type ExitCode } from "./errors";
import { formatFields, formatTable, print, type Output } from "./output";

/** What the command runs with. bin.ts passes the real process; tests pass fakes. */
export type Io = { argv: string[]; env: NodeJS.ProcessEnv; out(text: string): void; err(text: string): void; readStdin?(): Promise<string>; fetch?: typeof fetch };

type Values = Record<string, string | boolean | undefined>;
type OptionSpec = Record<string, { type: "string" | "boolean"; short?: string }>;

type CommandContext = {
  io: Io;
  output: Output;
  values: Values;
  positionals: string[];
  configPath: string;
  /** The saved or overridden connection, and a client for it. */
  connect(): Promise<{ client: Client; connection: Connection }>;
};

type Command = { summary: string; usage: string; options?: OptionSpec; run(context: CommandContext): Promise<void> };

const globalOptions: OptionSpec = {
  profile: { type: "string" },
  business: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

function stringValue(values: Values, name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

function businessId(value: string | undefined): string | undefined {
  if (value !== undefined && !isUuid(value)) throw new CliError(`--business must be a business id, a UUID such as 5d0bd9a4-7e1c-4a51-9a50-8e1b2c3d4e5f.`);
  return value;
}

const commands: Record<string, Command> = {
  login: {
    summary: "Check an API key and save it, with the dashboard's address, as a profile.",
    usage: "lobbystack login --url <dashboard URL> --key <API key> [--profile <name>] [--business <id>]\nlobbystack login --url <dashboard URL> --key-stdin [--profile <name>] [--business <id>]\nlobbystack login [--profile <name>] [--business <id>], with LOBBYSTACK_URL and LOBBYSTACK_API_KEY set\n\n--key-stdin reads the key from standard input, which keeps it out of your shell history.",
    options: { url: { type: "string" }, key: { type: "string" }, "key-stdin": { type: "boolean" } },
    async run({ io, output, values, configPath: path }) {
      // The address and the key come from one place, so a key is only ever checked against the server it's saved for.
      const flagged = values.url !== undefined || values.key !== undefined || values["key-stdin"] !== undefined;
      if (flagged && (values.url === undefined || (values.key === undefined) === (values["key-stdin"] !== true))) throw new CliError(`Pass --url with either --key or --key-stdin.\nUsage: ${commands.login!.usage}`);
      const url = flagged ? stringValue(values, "url") : io.env.LOBBYSTACK_URL?.trim();
      const key = flagged ? (stringValue(values, "key") ?? await io.readStdin?.())?.trim() : io.env.LOBBYSTACK_API_KEY?.trim();
      if (!url || !key) throw new CliError(`Pass the dashboard's address and an API key.\nUsage: ${commands.login!.usage}`);
      const name = assertProfileName(stringValue(values, "profile") ?? DEFAULT_PROFILE);
      const base = normalizeBaseUrl(url);
      const business = businessId(stringValue(values, "business"));
      const me = (await createClient({ url: base, key, business, ...(io.fetch ? { fetch: io.fetch } : {}) }).call("getMe")).data;
      const config = await readConfig(path);
      config.profiles[name] = { url: base, key, ...(business ? { business } : {}) };
      config.current = name;
      await writeConfig(path, config);
      const pick = me.platform && !me.business ? " It's a platform key: name the business to act on with --business <id> or LOBBYSTACK_BUSINESS." : "";
      print(output, { profile: name, url: base, ...me }, () => `Logged in to ${base} with ${me.api_key.name} (${me.api_key.prefix}). Commands now use the ${name} profile.${me.business ? ` Business: ${me.business.name}.` : ""}${pick}`);
    },
  },
  logout: {
    summary: "Forget a profile and the API key saved with it.",
    usage: "lobbystack logout [--profile <name>]",
    async run({ output, values, configPath: path }) {
      const config = await readConfig(path);
      const name = stringValue(values, "profile") ?? config.current ?? DEFAULT_PROFILE;
      if (!config.profiles[name]) throw new CliError(`There's no profile named ${name}.`);
      delete config.profiles[name];
      if (config.current === name) delete config.current;
      await writeConfig(path, config);
      print(output, { profile: name, removed: true }, () => `Removed the ${name} profile. The key still works until you revoke it in the dashboard, or in PLATFORM_API_KEYS for a platform key.`);
    },
  },
  whoami: {
    summary: "Show the API key in use, its business and its scopes.",
    usage: "lobbystack whoami [--profile <name>] [--business <id>]",
    async run({ output, connect }) {
      const { client, connection } = await connect();
      const me = (await client.call("getMe")).data;
      print(output, { profile: connection.profile, url: connection.url, ...me }, () => formatFields([
        ["Profile", connection.profile ? `${connection.profile} (${connection.url})` : `LOBBYSTACK_URL and LOBBYSTACK_API_KEY (${connection.url})`],
        ["API key", `${me.api_key.name} (${me.api_key.prefix})`],
        ...(me.platform ? [["Partner", `${me.platform.partner}, access to ${me.platform.access === "all" ? "every business" : "its own businesses"}`] as const] : []),
        ["Business", me.business ? `${me.business.name} (${me.business.id})` : "none"],
        ["Scopes", me.api_key.scopes],
      ]));
    },
  },
  profiles: {
    summary: "List the saved profiles, or pick the one commands use.",
    usage: "lobbystack profiles\nlobbystack profiles use <name>",
    async run({ output, positionals, configPath: path }) {
      const config = await readConfig(path);
      const [action, name, ...extra] = positionals;
      if (action === "use") {
        if (!name || extra.length) throw new CliError(`Usage: ${commands.profiles!.usage}`);
        if (!config.profiles[name]) throw new CliError(`There's no profile named ${name}.`);
        config.current = name;
        await writeConfig(path, config);
        print(output, { current: name }, () => `Commands now use the ${name} profile.`);
        return;
      }
      if (action !== undefined) throw new CliError(`Usage: ${commands.profiles!.usage}`);
      const current = config.current ?? DEFAULT_PROFILE;
      // The key's prefix only: the secret part stays in the file.
      const rows = Object.entries(config.profiles).map(([profile, entry]) => ({ profile, current: profile === current, url: entry.url, key: keyPrefix(entry.key), business: entry.business ?? null }));
      print(output, rows, () => formatTable(rows.map((row) => ({ ...row, current: row.current ? "yes" : "" })), [{ key: "profile", label: "Profile" }, { key: "current", label: "In use" }, { key: "url", label: "URL" }, { key: "key", label: "Key" }, { key: "business", label: "Business" }]));
    },
  },
};

function helpText(): string {
  const width = Math.max(...Object.keys(commands).map((name) => name.length));
  return [
    "Usage: lobbystack <command> [options]",
    "",
    "Commands:",
    ...Object.entries(commands).map(([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`),
    "",
    "Options for every command:",
    "  --profile <name>  Use this saved profile instead of the one in use.",
    "  --business <id>   Act on this business. A platform key needs one for most commands.",
    "  --json            Print JSON, for scripts.",
    "  -h, --help        Show help for a command.",
    "",
    "LOBBYSTACK_URL, LOBBYSTACK_API_KEY and LOBBYSTACK_BUSINESS override the profile's values.",
    "",
    "Exit codes: 0 done. 1 LobbyStack or the network failed, or a rate limit: try again later.",
    "2 the command or its input is wrong. 3 the API key is missing or invalid, or isn't allowed to do this.",
  ].join("\n");
}

function reportError(io: Io, json: boolean, error: CliError): void {
  const details = error instanceof ApiError ? error.details : [];
  if (json) {
    io.err(JSON.stringify({ error: { message: error.message, exit_code: error.exitCode, ...(error instanceof ApiError ? { status: error.status, code: error.code, details } : {}) } }, null, 2));
    return;
  }
  io.err([error.message, ...details.map((detail) => `  ${detail.path}: ${detail.message}`)].join("\n"));
}

export async function main(io: Io): Promise<ExitCode> {
  const json = io.argv.includes("--json");
  try {
    const [name, ...rest] = io.argv;
    if (name === undefined || name === "help" || name === "--help" || name === "-h") {
      io.out(helpText());
      return exitCodes.ok;
    }
    const command = commands[name];
    if (!command) throw new CliError(`There's no ${name} command. Run lobbystack help to see them.`);
    let parsed: { values: Values; positionals: string[] };
    try {
      parsed = parseArgs({ args: rest, options: { ...globalOptions, ...command.options }, allowPositionals: true, strict: true }) as { values: Values; positionals: string[] };
    } catch (error) {
      throw new CliError(`${error instanceof Error ? error.message : String(error)}\nUsage: ${command.usage}`);
    }
    if (parsed.values.help) {
      io.out(`${command.summary}\n\nUsage: ${command.usage}`);
      return exitCodes.ok;
    }
    const path = configPath(io.env);
    const output: Output = { json, out: io.out, err: io.err };
    await command.run({
      io,
      output,
      values: parsed.values,
      positionals: parsed.positionals,
      configPath: path,
      async connect() {
        const connection = resolveConnection(await readConfig(path), io.env, { profile: stringValue(parsed.values, "profile"), business: businessId(stringValue(parsed.values, "business")) });
        return { connection, client: createClient({ url: connection.url, key: connection.key, business: connection.business, ...(io.fetch ? { fetch: io.fetch } : {}) }) };
      },
    });
    return exitCodes.ok;
  } catch (error) {
    if (error instanceof CliError) {
      reportError(io, json, error);
      return error.exitCode;
    }
    io.err(`Something went wrong: ${error instanceof Error ? error.message : String(error)}`);
    return exitCodes.failed;
  }
}
