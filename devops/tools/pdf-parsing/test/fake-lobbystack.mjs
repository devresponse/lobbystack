// A stand-in for the lobbystack CLI's bin.js in tests: it answers whoami, knowledge upload,
// knowledge source-remove and knowledge search with --json, keeping its sources in the JSON
// file FAKE_LOBBYSTACK_STATE names. The search hands over every uploaded file as a passage.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const state = process.env.FAKE_LOBBYSTACK_STATE;
const data = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : { next: 1, sources: [], calls: [] };
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? undefined : args[at + 1];
};
const business = option("business") ?? "biz_default";
data.calls.push(args);
const done = (value, code = 0) => {
  writeFileSync(state, JSON.stringify(data, null, 2));
  if (code === 0) process.stdout.write(JSON.stringify(value, null, 2));
  else process.stderr.write(JSON.stringify({ error: value }, null, 2));
  process.exit(code);
};

if (!args.includes("--json")) done({ message: "the tool always asks for --json" }, 2);
const [group, command, target] = args;
if (group === "whoami") done({ profile: "test", url: "https://demo.example.test", api_key: { name: "test", prefix: "lsk_test" }, business: { id: business, name: "Test business" } });
if (group === "knowledge" && command === "upload") {
  const source = { id: `src_${data.next++}`, type: "file", title: option("title"), status: "indexed", error: null, tags: (option("tags") ?? "").split(","), file: target, content: readFileSync(target, "utf8"), business };
  data.sources.push(source);
  done({ id: source.id, type: source.type, title: source.title, status: source.status, error: null, tags: source.tags });
}
if (group === "knowledge" && command === "source-remove") {
  const before = data.sources.length;
  data.sources = data.sources.filter((source) => source.id !== target);
  if (data.sources.length === before) done({ message: "Knowledge source not found." }, 1);
  done({ id: target, deleted: true });
}
if (group === "knowledge" && command === "search") {
  const folder = option("log-dir");
  if (folder) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, `search-${data.calls.length}.json`), JSON.stringify({ query: target }));
  }
  const evidence = data.sources.filter((source) => source.business === business).map((source, index) => ({ title: source.title, sequence: 0, rank: index + 1, content: source.content }));
  done({ outcome: evidence.length ? "found" : "empty", mode: "hybrid", duration_ms: 12, evidence });
}
done({ message: `unknown command ${args.join(" ")}` }, 2);
