import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// The control panel on a developer's computer (docs/features/control-panel.md):
// it reads the same .env files as the admin, and listens on CONTROL_PORT.
const root = fileURLToPath(new URL("../../..", import.meta.url));
// Inherited variables win, and .env.local beats .env: loadEnvFile never replaces a key that is already set.
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(`${root}/${file}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

process.env.PORT = process.env.CONTROL_PORT || "13003";
process.argv.splice(2, 0, "dev");

const require = createRequire(import.meta.url);
require("../node_modules/next/dist/bin/next");
