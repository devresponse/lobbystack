#!/usr/bin/env node
// Writes .env from .env.example with every internal secret generated. Provider credentials
// (Twilio, Polar, ...) are cleared rather than generated: only the operator can supply them.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER_CREDENTIALS = new Set(["TWILIO_AUTH_TOKEN", "POLAR_WEBHOOK_SECRET"]);
const PLACEHOLDER_PREFIX = "replace-with-";

export function generateEnv(example, random = () => randomBytes(32).toString("hex")) {
  const generated = [];
  const valuesByPlaceholder = new Map();
  const output = example
    .split("\n")
    .map((line) => {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (!match) return line;
      const [, key, value] = match;
      if (!value.startsWith(PLACEHOLDER_PREFIX)) {
        // Reuse generated secrets inside composite values such as DATABASE_URL.
        let resolved = value;
        for (const [placeholder, secret] of valuesByPlaceholder) resolved = resolved.replaceAll(placeholder, secret);
        return `${key}=${resolved}`;
      }
      if (PROVIDER_CREDENTIALS.has(key)) return `${key}=`;
      generated.push(key);
      const secret = random();
      valuesByPlaceholder.set(value, secret);
      return `${key}=${secret}`;
    })
    .join("\n");
  return { output, generated };
}

function main() {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const target = resolve(root, ".env");
  if (existsSync(target) && !process.argv.includes("--force")) {
    console.error(".env already exists. Rerun with --force to replace it and every secret in it.");
    process.exit(1);
  }
  const { output, generated } = generateEnv(readFileSync(resolve(root, ".env.example"), "utf8"));
  writeFileSync(target, output, { mode: 0o600 });
  console.log(`Wrote .env with ${generated.length} generated secrets.`);
  console.log("Add OPENAI_API_KEY and your Twilio credentials before you start calls.");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
