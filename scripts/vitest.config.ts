import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../", import.meta.url));

export default defineConfig({
  // Workspace packages from their sources, as tsx and the other packages' tests read them.
  resolve: {
    alias: {
      "@lobbystack/contracts": `${root}/packages/contracts/src/index.ts`,
      "@lobbystack/db": `${root}/packages/db/src/index.ts`,
      "@lobbystack/shared": `${root}/packages/shared/src/index.ts`,
      "@lobbystack/telemetry/node": `${root}/packages/telemetry/src/node.ts`,
      "@lobbystack/telemetry": `${root}/packages/telemetry/src/index.ts`,
    },
  },
  test: {
    include: ["scripts/**/*.test.ts"],
  },
});
